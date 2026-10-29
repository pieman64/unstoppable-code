// CAN-3790: a worktree create that fails with kilobytes of git output shows a
// compact notice above the New Task composer, not a banner that covers it and
// runs off the window. The full output opens in a scrolling dialog.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedChatsSectionFixture,
  CHATS_SECTION_CODE_WORKSPACE_ID,
} from './seeders/seedChatsSectionFixture.mjs';

/** A worktree-create failure shaped like the real ~7.8 KB git output. */
function buildPayload(separator) {
  const lines = [
    'Command failed while creating the binturong worktree from develop.',
    "Preparing worktree (new branch 'binturong-1791357289421')",
  ];
  for (let index = 0; lines.join(separator).length < 7800; index += 1) {
    lines.push(`Updating files:  ${index % 100}% (${index}/400)`);
    lines.push(
      `error: unable to create file src/generated/file-${index}.ts: No space left on device`,
    );
  }
  return lines.join(separator);
}

function intersects(a, b) {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

async function expectBoundedNotice(window, notice) {
  const box = await notice.boundingBox();
  expect(box).not.toBeNull();
  const viewport = await window.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(box.height).toBeLessThan(160);
  const main = window.getByTestId('page-main');
  for (const testId of ['home-composer-editor', 'home-composer']) {
    const target = await main.getByTestId(testId).boundingBox();
    expect(target).not.toBeNull();
    expect(intersects(box, target)).toBe(false);
  }
  expect(await notice.textContent()).not.toContain('Updating files:  50%');
}

test('a long worktree failure stays a compact notice above the composer', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-3790-'));
  seedChatsSectionFixture(userDataDir, { worktreeCount: 0, chatEntryCount: 0 });
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 800, height: 600 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    const main = window.getByTestId('page-main');
    await expect(main.getByTestId('home-composer')).toBeVisible();

    await electronApp.evaluate(({ ipcMain }, payload) => {
      ipcMain.removeHandler('worktree:create');
      ipcMain.handle('worktree:create', async () => {
        throw new Error(payload);
      });
    }, buildPayload('\r'));

    const project = window
      .getByTestId('sidebar-shared-rail')
      .locator(`[data-workspace-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"]`);
    await expect(project).toBeVisible();
    await project.hover();
    await app.workspaceHeaderLabel('Chats Section Code').hover();
    const create = window.getByRole('button', {
      name: /^Create (task|worktree) for Chats Section Code$/,
    });
    await create.focus();
    await create.press('Enter');

    const notice = main.getByTestId('worktree-error-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(
      'Command failed while creating the binturong worktree from develop.',
    );
    await expect(notice).toContainText('No space left on device');
    await expectBoundedNotice(window, notice);

    // The composer stays usable while the notice is showing.
    const editor = main.getByTestId('home-composer-editor');
    await editor.click();
    await window.keyboard.type('still typing');
    await expect(editor).toContainText('still typing');

    const details = notice.getByTestId('worktree-error-details');
    await details.click();
    const dialog = window.getByTestId('worktree-error-details-dialog');
    await expect(dialog).toBeVisible();
    const body = window.getByTestId('worktree-error-details-dialog-body');
    await expect(body).toContainText('Updating files:  50%');
    const bodyBox = await body.boundingBox();
    expect(bodyBox).not.toBeNull();
    expect(bodyBox.y + bodyBox.height).toBeLessThanOrEqual(600);
    expect(
      await body.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);

    await window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(notice).toBeVisible();
    await expect(details).toBeFocused();

    await window.setViewportSize({ width: 1100, height: 900 });
    await expectBoundedNotice(window, notice);

    await notice.getByTestId('worktree-error-dismiss').click();
    await expect(notice).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
