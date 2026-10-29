// @capture-keep: reusable light and dark gallery of the space notification menu states (default, saving, saved, failed)
// @capture-reference: docs/push-notifications.md
// Run with: pnpm run test:electron:captures:built can-3615-space-notification-menu.capture-spec.ts
// Color modes: run each documented stage normally for light, then append `--dark-mode` for dark.
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  ENTRY_ID,
  WORKSPACE_ID as COWORK_WORKSPACE_ID,
  expandCoworkWorkspace,
  openWorkEntryMenu,
  seedDeliveryCoworkWorkspace,
} from './coworkWorkEntryDoneFixture.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { startSpaceNotificationsCloudMock } from './spaceNotificationsCloudMock.mjs';

// CAN-3615 — per-space notification choices in the desktop row menus.
//
// Two follow-ups to the menu are visible here:
//   1. "Use default (All activity)" and "All activity" were separate rows.
//      Now there are three choices, with All activity checked for a space
//      that has no saved choice.
//   2. Every change used to grey out all choices and add a "Saving…" row, so
//      the menu changed ink and height on each pick (a visible flicker). Now
//      a save in flight shows a spinner in the pending row's check slot and
//      the menu keeps its look and height.
//
// Stages: `before` runs against the tree before both follow-ups (rebuild the
// E2E bundle from that tree first); `after` (default) runs against this one.
//
//   CAN3615_STAGE=before pnpm run test:electron:captures:built can-3615-space-notification-menu.capture-spec.ts --reporter=line
//   CAN3615_STAGE=before pnpm run test:electron:captures:built can-3615-space-notification-menu.capture-spec.ts --reporter=line --dark-mode
//   CAN3615_STAGE=after pnpm run test:electron:captures:built can-3615-space-notification-menu.capture-spec.ts --reporter=line
//   CAN3615_STAGE=after pnpm run test:electron:captures:built can-3615-space-notification-menu.capture-spec.ts --reporter=line --dark-mode
//
// Determinism: demo workspaces and the Cowork entry are seeded on disk, and
// choices are saved through a per-test local cloud mock that can hold a save
// in flight, so the saving state is captured without timing races.

const STAGE = process.env.CAN3615_STAGE === 'before' ? 'before' : 'after';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'can-3615');

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const NOTIFY = 'worktree-actions-menu-notifications';

async function connectCloud(page: Page): Promise<void> {
  const result = await page.evaluate(
    async (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
    'csk_space_notifications_e2e',
  );
  expect(result.status.authenticated).toBe(true);
}

async function capture(locator: Locator, name: string): Promise<void> {
  await locator.screenshot({
    path: path.join(captureDir, `${name}-${STAGE}.png`),
    animations: 'disabled',
  });
}

async function openWorktreeMenu(window: Page): Promise<Locator> {
  const section = window.getByTestId(`sidebar-project-${WORKSPACE_ID}`);
  await section.getByTestId('worktree-row').first().hover();
  await section
    .getByTestId('worktree-actions-menu-button')
    .first()
    .click({ force: true });
  const menu = window.getByTestId('worktree-actions-menu');
  await expect(menu).toBeVisible();
  return menu;
}

async function expectSettledOn(window: Page, key: string): Promise<void> {
  await expect(window.getByTestId(`${NOTIFY}-${key}`)).toHaveAttribute(
    'aria-checked',
    'true',
    { timeout: 15_000 },
  );
}

test('captures the code worktree notification menu states', async () => {
  test.setTimeout(180_000);
  mkdirSync(captureDir, { recursive: true });
  const cloud = await startSpaceNotificationsCloudMock();
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-3615-capture-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
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

    // 1. A space with no saved choice.
    const menu = await openWorktreeMenu(window);
    await expectSettledOn(
      window,
      STAGE === 'before' ? 'notify-default' : 'notify-all',
    );
    await capture(menu, 'worktree-default');

    // 2. A save in flight: held at the server so the state is stable.
    const release = cloud.holdNextSave();
    await window.getByTestId(`${NOTIFY}-notify-mute`).click();
    if (STAGE === 'before') {
      await expect(window.getByTestId(`${NOTIFY}-status`)).toContainText(
        'Saving…',
      );
    } else {
      await expect(
        window
          .getByTestId(`${NOTIFY}-notify-mute`)
          .locator('.animate-loading-dot')
          .first(),
      ).toBeAttached();
    }
    await capture(menu, 'worktree-saving');

    // 3. The save lands.
    release();
    await expectSettledOn(window, 'notify-mute');
    await expect(window.getByTestId(`${NOTIFY}-status`)).toHaveCount(0);
    await capture(menu, 'worktree-saved-mute');

    // 4. A save that fails keeps the stored choice and says so.
    cloud.failNextSave();
    await window.getByTestId(`${NOTIFY}-notify-attention`).click();
    await expect(window.getByTestId(`${NOTIFY}-status`)).toContainText(
      'Couldn’t save. Try again.',
    );
    await expectSettledOn(window, 'notify-mute');
    await capture(menu, 'worktree-save-failed');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('captures the Cowork Work Entry notification menu', async () => {
  test.setTimeout(180_000);
  mkdirSync(captureDir, { recursive: true });
  const cloud = await startSpaceNotificationsCloudMock();
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-3615-capture-cowork-'),
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
    const group = window.getByTestId(`${prefix}-notify`);
    await expect(
      group.locator('[role="menuitemradio"][aria-checked="true"]'),
    ).toHaveCount(1, { timeout: 15_000 });
    const menu = window.locator('[role="menu"]').filter({ has: group });
    await capture(menu, 'work-entry-default');

    const release = cloud.holdNextSave();
    await window.getByTestId(`${prefix}-notify-attention`).click();
    if (STAGE === 'before') {
      await expect(window.getByTestId(`${prefix}-notify-status`)).toContainText(
        'Saving…',
      );
    } else {
      await expect(
        window
          .getByTestId(`${prefix}-notify-attention`)
          .locator('.animate-loading-dot')
          .first(),
      ).toBeAttached();
    }
    await capture(menu, 'work-entry-saving');
    release();
    await expect(
      window.getByTestId(`${prefix}-notify-attention`),
    ).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
    await capture(menu, 'work-entry-saved-attention');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
