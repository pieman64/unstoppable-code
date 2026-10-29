// CAN-390: real seeded desktop navigation, frozen chat rows and canonical reads.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedActivityModeFixture } from './seeders/seedActivityModeFixture.mjs';
import { readChatStorageIndexes } from './readChatStorage.mjs';

test('Activity lists individual chats, appends a page, and clears reads in place', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can390-'));
  const fixture = seedActivityModeFixture(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1280, height: 900 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.showSidebar();
    await app.openOverviewPage();
    const bell = window.getByTestId('sidebar-activity-toggle');
    await expect(bell).toHaveCount(1);
    await expect(bell).toHaveAttribute('aria-label', 'Activity');
    await bell.click();
    const list = window.getByTestId('sidebar-activity');
    await expect(list).toBeVisible();
    await expect(bell).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId('sidebar-section-code')).toHaveCount(0);
    // Opened right after launch, before startup hydration reaches the seeded
    // worktree: its persisted unread chat still classifies as Unread.
    await expect(
      list
        .getByTestId('sidebar-activity-section-unread')
        .getByTestId(`sidebar-activity-row-${fixture.unreadChatId}`),
    ).toBeVisible();
    const unreplied = list.getByTestId('sidebar-activity-section-unreplied');
    await expect(unreplied.locator('li')).toHaveCount(50);
    const before = await unreplied
      .locator('li')
      .evaluateAll((rows) => rows.map((row) => row.dataset.activityKey));
    await list.getByTestId('sidebar-activity-show-more').click();
    // 60 ordered replies plus the not-yet-started active-turn fixture target.
    await expect(unreplied.locator('li')).toHaveCount(61);
    expect(
      (
        await unreplied
          .locator('li')
          .evaluateAll((rows) => rows.map((row) => row.dataset.activityKey))
      ).slice(0, 50),
    ).toEqual(before);
    await expect(list.getByTestId('sidebar-activity-show-more')).toHaveCount(0);
    const unread = list.getByTestId(
      `sidebar-activity-row-${fixture.unreadChatId}`,
    );
    await expect(unread).toContainText(fixture.unreadChatId);
    const order = await list
      .locator('li')
      .evaluateAll((rows) => rows.map((row) => row.dataset.activityKey));
    await unread.click();
    await expect(unread).toHaveAttribute('aria-current', 'true');
    await expect(unread.getByTestId('worktree-row-unread')).toHaveCount(0);
    expect(
      await list
        .locator('li')
        .evaluateAll((rows) => rows.map((row) => row.dataset.activityKey)),
    ).toEqual(order);
    await expect
      .poll(
        () =>
          readChatStorageIndexes(
            path.join(userDataDir, 'workspaces', fixture.workspaceId),
            fixture.worktreeId,
          ).live.tabs.find((tab) => tab.id === fixture.unreadChatId)?.unread,
      )
      .toBe(false);
    await bell.click();
    await expect(list).toHaveCount(0);
    await expect(window.getByTestId('sidebar-section-code')).toBeVisible();
    await bell.click();
    await expect(
      window
        .getByTestId('sidebar-activity-section-unread')
        .getByTestId(`sidebar-activity-row-${fixture.unreadChatId}`),
    ).toHaveCount(0);
    await bell.click();
    const draftTab = window.getByTestId(
      `panel-tab-panel-chat-${fixture.draftChatId}`,
    );
    await draftTab.scrollIntoViewIfNeeded();
    await draftTab.click();
    const composer = window
      .locator('[data-chat-textarea][contenteditable="true"]:visible')
      .first();
    await composer.fill('Activity draft created through the composer');
    await bell.click();
    const draftRow = window
      .getByTestId('sidebar-activity-section-drafts')
      .getByTestId(`sidebar-activity-row-${fixture.draftChatId}`);
    await expect(draftRow).toBeVisible();
    await composer.fill('');
    await expect(draftRow).toBeVisible();
    await bell.click();
    await bell.click();
    await expect(window.getByTestId('sidebar-activity')).toBeVisible();
    await expect(
      window.getByTestId('sidebar-activity-section-drafts'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
