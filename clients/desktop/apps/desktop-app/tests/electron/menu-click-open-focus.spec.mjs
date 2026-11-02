import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  COPY_LINK_CHAT_ID,
  COPY_LINK_URL,
  seedCopyChat,
} from './fixtures/chat-message-copy.mjs';

/**
 * One rule for every menu: opened with the mouse, the row the menu starts on
 * holds focus without being painted, the first arrow key paints that row
 * (rather than moving past it), and later arrows move. Keyboard focus on a
 * row is the hover fill, never the focus ring. Two families: a picker built
 * on the shared menu (approvals) and a right-click menu (a link in a chat reply).
 */

function focusState(window) {
  return window.evaluate(() => {
    const element = document.activeElement;
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--bg-subtle)';
    document.body.append(probe);
    const subtle = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const style = element ? getComputedStyle(element) : null;
    return {
      role: element?.getAttribute('role') ?? null,
      text: element?.textContent?.trim() ?? '',
      visible: element?.matches(':focus-visible') ?? false,
      outline: style?.outlineStyle ?? null,
      filled: style?.backgroundColor === subtle,
    };
  });
}

async function expectClickOpenThenArrows(window, rowRole) {
  const opened = await focusState(window);
  expect(opened.role).toBe(rowRole);
  expect(opened.visible).toBe(false);
  expect(opened.outline).toBe('none');

  // The first arrow paints the row that holds focus.
  await window.keyboard.press('ArrowDown');
  const painted = await focusState(window);
  expect(painted.text).toBe(opened.text);
  expect(painted.visible).toBe(true);
  expect(painted.outline).toBe('none');
  expect(painted.filled).toBe(true);

  // Then the arrows move.
  await window.keyboard.press('ArrowDown');
  const moved = await focusState(window);
  expect(moved.role).toBe(rowRole);
  expect(moved.text).not.toBe(opened.text);
  expect(moved.outline).toBe('none');
  await window.keyboard.press('Escape');
}

test('menus opened with the mouse paint a row only once an arrow key is pressed', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-menu-click-open-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedCopyChat({ userDataDir });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    // A picker on the shared menu: the approval mode picker.
    const picker = window.getByTestId('approval-mode-picker');
    await expect(picker).toBeVisible();
    await picker.click();
    await expect(window.getByTestId('approval-mode-option-ask')).toBeVisible();
    await expectClickOpenThenArrows(window, 'menuitemradio');
    await expect(window.getByTestId('approval-mode-option-ask')).toHaveCount(0);

    // A right-click menu: the chat reply's.
    const reply = window
      .locator('[data-chat-message-id="copy-assistant"]')
      .first();
    await expect(reply).toBeVisible();
    await reply.click({ button: 'right' });
    await expect(window.getByTestId('chat-message-context-menu')).toBeVisible();
    const replyMenu = window.getByTestId('chat-message-context-menu');
    await expect(replyMenu.getByRole('menuitem')).toHaveCount(1);
    await expect(
      replyMenu.getByRole('menuitem', { name: 'Copy selection' }),
    ).toBeDisabled();
    await window.keyboard.press('Escape');

    // Link actions retain multiple enabled rows for arrow navigation.
    await window
      .getByTestId(`panel-tab-panel-chat-${COPY_LINK_CHAT_ID}`)
      .click();
    await window
      .locator(`a[href="${COPY_LINK_URL}"]:visible`)
      .first()
      .click({ button: 'right' });
    await expect(replyMenu).toBeVisible();
    await expectClickOpenThenArrows(window, 'menuitem');
    await expect(window.getByTestId('chat-message-context-menu')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
