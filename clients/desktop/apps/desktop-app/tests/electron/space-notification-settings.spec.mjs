/**
 * Per-space notification choices (CAN-3615), end to end on the desktop.
 *
 * Code worktree and Cowork Work Entry menus, through both the "…" button and
 * a right-click, offer All activity (checked by default), Needs my attention,
 * and Mute. A choice is saved through the real producer sync and PATCH routes of
 * a per-test cloud server (which sees only keyed references to local ids),
 * survives a reload, and reports failed and conflicting saves. A muted space raises no popup for a finished turn while
 * its unread dot, notification history, and other spaces are unchanged.
 *
 *   pnpm run test:electron:built space-notification-settings.spec.mjs --reporter=line
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';
import { startSpaceNotificationsCloudMock } from './spaceNotificationsCloudMock.mjs';
import {
  ENTRY_ID,
  WORKSPACE_ID as COWORK_WORKSPACE_ID,
  expandCoworkWorkspace,
  openWorkEntryMenu,
  seedDeliveryCoworkWorkspace,
} from './coworkWorkEntryDoneFixture.mjs';

const MUTED_WORKSPACE = 'demo-ts-pnpm-vite';
const OTHER_WORKSPACE = 'demo-ts-yarn-cli';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'space-notify-chat';
const NOTIFY = 'worktree-actions-menu-notifications';
const CHOICES = ['notify-all', 'notify-attention', 'notify-mute'];

async function connectCloud(window) {
  const result = await window.evaluate(
    async (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
    'csk_space_notifications_e2e',
  );
  expect(result.status.authenticated).toBe(true);
}

function projectSection(window, workspaceId) {
  return window.getByTestId(`sidebar-project-${workspaceId}`);
}

async function openWorktreeMenu(window, workspaceId, via) {
  const section = projectSection(window, workspaceId);
  const row = section.getByTestId('worktree-row').first();
  await row.hover();
  if (via === 'right-click') {
    await row.click({ button: 'right' });
  } else {
    await section
      .getByTestId('worktree-actions-menu-button')
      .first()
      .click({ force: true });
  }
  await expect(window.getByTestId('worktree-actions-menu')).toBeVisible();
}

async function closeMenu(window) {
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('worktree-actions-menu')).toHaveCount(0);
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

function seedChats(userDataDir) {
  for (const workspaceId of [MUTED_WORKSPACE, OTHER_WORKSPACE]) {
    seedWorktreeChat({
      userDataDir,
      workspaceId,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      tabs: [
        {
          id: CHAT_ID,
          title: `Chat in ${workspaceId}`,
          messages: [
            {
              id: 'assistant-preview',
              role: 'assistant',
              blocks: [{ type: 'text', text: `Answer from ${workspaceId}.` }],
              timestamp: Date.parse('2026-10-04T12:00:00.000Z'),
            },
          ],
        },
      ],
    });
  }
}

test('code worktree menus save, persist, and enforce a space choice', async () => {
  test.setTimeout(240_000);
  const cloud = await startSpaceNotificationsCloudMock();
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-space-notifications-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite', 'ts-yarn-cli'] });
  seedChats(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await connectCloud(window);

    // The "…" menu shows the three choices with All activity checked.
    await openWorktreeMenu(window, MUTED_WORKSPACE, 'button');
    await expectChecked(window, NOTIFY, 'notify-all');
    await expect(window.getByTestId(`${NOTIFY}-notify-all`)).toContainText(
      'All activity',
    );

    // Every choice saves and is reported checked only once acknowledged.
    // All activity clears the override rather than storing `all`.
    for (const [key, override] of [
      ['notify-attention', 'attention'],
      ['notify-all', null],
      ['notify-mute', 'mute'],
    ]) {
      await window.getByTestId(`${NOTIFY}-${key}`).click();
      await expectChecked(window, NOTIFY, key);
      await expect
        .poll(() => cloud.choiceFor(MUTED_WORKSPACE, WORKTREE_ID))
        .toBe(override);
    }
    await closeMenu(window);
    // Registration sends keyed references, never the local ids themselves.
    expect(cloud.sawLocalId(MUTED_WORKSPACE)).toBe(false);

    // Right-click opens the same menu, and the choice survives a reload.
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await openWorktreeMenu(window, MUTED_WORKSPACE, 'right-click');
    await expectChecked(window, NOTIFY, 'notify-mute');

    // A failed save keeps the saved choice and says so.
    cloud.failNextSave();
    await window.getByTestId(`${NOTIFY}-notify-all`).click();
    await expect(window.getByTestId(`${NOTIFY}-status`)).toContainText(
      'Couldn’t save. Try again.',
    );
    await expectChecked(window, NOTIFY, 'notify-mute');

    // A save that lost to another device shows the authoritative choice.
    cloud.conflictNextSave();
    await window.getByTestId(`${NOTIFY}-notify-all`).click();
    await expect(window.getByTestId(`${NOTIFY}-status`)).toContainText(
      'This changed somewhere else. Showing the latest.',
    );
    await expectChecked(window, NOTIFY, 'notify-attention');

    // Back to Mute for the delivery check.
    await window.getByTestId(`${NOTIFY}-notify-mute`).click();
    await expectChecked(window, NOTIFY, 'notify-mute');
    await closeMenu(window);

    // A finished turn in the muted space raises no popup, but its unread dot
    // and notification history are recorded as before.
    await app.openOverviewPage();
    await injectChatEvent(electronApp, {
      projectId: MUTED_WORKSPACE,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: { type: 'result', is_error: false, result: 'Done' },
    });
    await expect(
      projectSection(window, MUTED_WORKSPACE).getByTestId(
        'worktree-row-unread',
      ),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      window.getByTestId('overview-notification-card').filter({
        hasText: `Answer from ${MUTED_WORKSPACE}.`,
      }),
    ).toBeVisible();
    await expect(
      window.locator('div.pointer-events-auto', {
        hasText: `Answer from ${MUTED_WORKSPACE}.`,
      }),
    ).toHaveCount(0);

    // Another space is unaffected.
    await injectChatEvent(electronApp, {
      projectId: OTHER_WORKSPACE,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: { type: 'result', is_error: false, result: 'Done' },
    });
    await expect(
      window
        .locator('div.pointer-events-auto', {
          hasText: `Answer from ${OTHER_WORKSPACE}.`,
        })
        .filter({ has: window.locator('button[aria-label="Expand"]') }),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('a Cowork Work Entry menu saves its own space choice', async () => {
  test.setTimeout(180_000);
  const cloud = await startSpaceNotificationsCloudMock();
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-space-notifications-cowork-'),
  );
  seedDeliveryCoworkWorkspace(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectCloud(window);
    await expandCoworkWorkspace(window, COWORK_WORKSPACE_ID);
    const prefix = `sidebar-work-entry-${ENTRY_ID}`;

    await openWorkEntryMenu(window, ENTRY_ID);
    await expectChecked(window, prefix, 'notify-all');
    await window.getByTestId(`${prefix}-notify-attention`).click();
    // The menu stays open to show the saved outcome.
    await expectChecked(window, prefix, 'notify-attention');
    await expect
      .poll(() => cloud.choiceFor(COWORK_WORKSPACE_ID, ENTRY_ID))
      .toBe('attention');
    await window.keyboard.press('Escape');

    // Right-click opens the same choices, still showing the saved one.
    await window
      .getByTestId(`sidebar-work-entry-${ENTRY_ID}`)
      .click({ button: 'right' });
    await expectChecked(window, prefix, 'notify-attention');
    await window.getByTestId(`${prefix}-notify-all`).click();
    await expectChecked(window, prefix, 'notify-all');
    await expect
      .poll(() => cloud.choiceFor(COWORK_WORKSPACE_ID, ENTRY_ID))
      .toBe(null);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
