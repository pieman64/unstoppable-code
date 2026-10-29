// A desktop chat's pending-delivery rows render through the shared
// `InputDeliveryList`, which shows a message carrying a watcher notice block
// (`<system_instruction>` with a `<canopy_watcher_event>`, as a cloud chat
// delivers a watcher wake-up) as its short notice under the watcher title,
// never the instruction block or the event payload. Desktop's own watcher
// deliveries keep that block out of the visible text; a message whose text
// carries it can still reach a desktop row, typed or sent over Remote Control.
//
// The row is seeded into the chat's input-delivery ledger (no provider, no
// network) and hydrated through the real renderer.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  WATCHER_NOTICE_WORKTREE_ID,
  seedWatcherNoticeRow,
} from './seeders/watcherNoticeRow.mjs';

test('a pending message carrying a watcher notice shows the notice, not its payload', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-notice-row-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWatcherNoticeRow(userDataDir);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WATCHER_NOTICE_WORKTREE_ID);

    const bubble = window
      .getByTestId('input-delivery-row')
      .getByTestId('input-delivery-bubble');
    await expect(bubble).toHaveCount(1);
    await expect(bubble.getByTestId('watcher-fired-title')).toHaveText(
      'Dark mode plan finished watcher has fired',
    );
    await expect(bubble).toContainText('Canopy watcher fired.');
    await expect(bubble).toContainText('Dark mode plan finished');
    await expect(bubble).not.toContainText('system_instruction');
    await expect(bubble).not.toContainText('canopy_watcher_event');
    await expect(bubble).not.toContainText('The plan is ready for review.');
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});
