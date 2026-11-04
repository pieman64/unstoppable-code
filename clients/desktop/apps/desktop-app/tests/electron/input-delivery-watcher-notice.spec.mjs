// A desktop chat's pending-delivery rows render through the shared
// `InputDeliveryList`. A message carrying a watcher notice block
// (`<system_instruction>` with a `<canopy_watcher_event>`) shows only its short
// notice, never the instruction block or the event payload. Only the host's
// watcher marker earns the watcher title (REG-3117); the same block typed by a
// person, or sent over Remote Control, stays an ordinary bubble.
//
// The rows are seeded into the chat's input-delivery ledger (no provider, no
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
  MARKED_ROW_ID,
  TYPED_ROW_ID,
  WATCHER_NOTICE_WORKTREE_ID,
  seedWatcherNoticeRow,
} from './seeders/watcherNoticeRow.mjs';

test('a pending watcher notice shows the notice, not its payload, and only a marked row is titled', async () => {
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

    const rows = window.getByTestId('input-delivery-row');
    await expect(rows).toHaveCount(2);
    const bubble = (id) =>
      window
        .locator(`[data-input-row-id="${id}"]`)
        .getByTestId('input-delivery-bubble');

    const marked = bubble(MARKED_ROW_ID);
    await expect(marked.getByTestId('watcher-fired-title')).toHaveText(
      'Dark mode plan finished watcher has fired',
    );
    const typed = bubble(TYPED_ROW_ID);
    await expect(typed.getByTestId('watcher-fired-title')).toHaveCount(0);

    for (const shown of [marked, typed]) {
      await expect(shown).toContainText('Canopy watcher fired.');
      await expect(shown).toContainText('Dark mode plan finished');
      await expect(shown).not.toContainText('system_instruction');
      await expect(shown).not.toContainText('canopy_watcher_event');
      await expect(shown).not.toContainText('The plan is ready for review.');
    }
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});
