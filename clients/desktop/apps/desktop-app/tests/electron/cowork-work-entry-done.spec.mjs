/**
 * Cowork Work Entry "Done" state (Impact delivery track).
 *
 * A Cowork Work Entry is the non-code analogue of a merged PR, so it needs a
 * user-driven "finished" marker: Cowork has no PR-merge signal, and the Impact
 * delivery track pays a `doneBonus` for an entry the user actually marked Done.
 * This spec walks the realistic flow through the sidebar row's "…" menu:
 *
 *   open a Cowork workspace → open the entry menu → Mark done → assert the done
 *   state (status glyph + `data-entry-status`) → Mark active → assert it clears
 *
 * Deterministic: the workspace, its Work Entry, and its chat are all seeded on
 * disk before launch, so no agent runs and no network is touched. The round trip
 * is asserted against `work-entries.json` as well as the DOM, which proves the
 * renderer store → `work-entries:update` IPC → registry path end to end.
 *
 *   pnpm exec playwright test cowork-work-entry-done.spec.mjs --reporter=line
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedBrowserProfileState,
  readBrowserProfileState,
} from './seeders/browser-profile-state.mjs';
import {
  ENTRY_ID,
  WORKSPACE_ID,
  expandCoworkWorkspace,
  openWorkEntryMenu,
  readEntryStatus,
  seedDeliveryCoworkWorkspace,
} from './coworkWorkEntryDoneFixture.mjs';

test('marks a Cowork Work Entry done from its sidebar menu and back to active', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-done-'),
  );
  const workspaceDir = seedDeliveryCoworkWorkspace(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await expandCoworkWorkspace(window, WORKSPACE_ID);

    const row = window.getByTestId(`sidebar-work-entry-${ENTRY_ID}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await app.expectChatPage();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 15_000,
    });
    await expect(window.getByTestId('standalone-chat-loading')).toHaveCount(0);
    await expect(row).toHaveAttribute('data-entry-status', 'active');
    await expect(
      window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-done`),
    ).toHaveCount(0);

    const browserFixture = await seedBrowserProfileState(electronApp, window, {
      projectId: WORKSPACE_ID,
      worktreeId: ENTRY_ID,
    });

    // Mark done.
    await openWorkEntryMenu(window, ENTRY_ID);
    const toggle = window.getByTestId(
      `sidebar-work-entry-${ENTRY_ID}-toggle-done`,
    );
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText('Mark done');
    await toggle.click();
    await expect(
      window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-menu-popover`),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        window.evaluate(() => document.body.dataset.sidebarMenuOpen ?? null),
      )
      .toBeNull();

    await expect(row).toHaveAttribute('data-entry-status', 'done', {
      timeout: 15_000,
    });
    const doneGlyph = window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-done`);
    await expect(doneGlyph).toBeVisible();
    await expect(doneGlyph).toHaveAttribute('aria-label', 'Done');
    await expect
      .poll(() => readEntryStatus(workspaceDir), { timeout: 15_000 })
      .toBe('done');
    expect(await readBrowserProfileState(electronApp, browserFixture)).toEqual({
      live: true,
      retained: true,
    });

    // Mark active again — the flag clears in the DOM and on disk.
    await openWorkEntryMenu(window, ENTRY_ID);
    const untoggle = window.getByTestId(
      `sidebar-work-entry-${ENTRY_ID}-toggle-done`,
    );
    await expect(untoggle).toContainText('Mark active');
    await untoggle.click();

    await expect(row).toHaveAttribute('data-entry-status', 'active', {
      timeout: 15_000,
    });
    await expect(
      window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-done`),
    ).toHaveCount(0);
    await expect
      .poll(() => readEntryStatus(workspaceDir), { timeout: 15_000 })
      .toBeUndefined();
    expect(await readBrowserProfileState(electronApp, browserFixture)).toEqual({
      live: true,
      retained: true,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
