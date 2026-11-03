import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedReplyActions,
  target,
} from './fixtures/turn-follow-up-actions.mjs';

test('every completed reply offers actions and forks only through the selected background reply', async () => {
  test.setTimeout(180000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'reply-actions-'));
  seedReplyActions(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  try {
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(target.worktreeId);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${target.chatId}"]`,
    );
    await expect(panel.getByTestId('wake-turn-boundary')).toHaveCount(2);
    await expect(panel.getByTestId('fork-chat-button')).toHaveCount(3);
    await expect(panel.getByTestId('turn-more-actions')).toHaveCount(3);
    await panel.getByTestId('turn-more-actions').nth(1).click();
    await expect(window.getByTestId('turn-more-branch')).toBeVisible();
    await expect(window.getByTestId('turn-more-share')).toHaveText(
      'Share session',
    );
    await expect(window.getByTestId('turn-feedback-up')).toBeVisible();
    await expect(window.getByTestId('turn-feedback-down')).toBeVisible();
    await window.getByTestId('turn-feedback-up').click();
    await panel.getByTestId('turn-more-actions').nth(1).click();
    await expect(window.getByTestId('turn-feedback-up')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await window.keyboard.press('Escape');
    await panel.getByTestId('turn-more-actions').first().click();
    await expect(window.getByTestId('turn-feedback-up')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await window.keyboard.press('Escape');
    await panel.getByTestId('fork-chat-button').nth(1).click();
    await expect
      .poll(async () => {
        const file = await window.evaluate(
          (t) => window.api.chat.loadTabs(t),
          target,
        );
        return file.tabs.length;
      })
      .toBe(2);
    const file = await window.evaluate(
      (t) => window.api.chat.loadTabs(t),
      target,
    );
    const fork = file.tabs.find((tab) => tab.id !== target.chatId);
    expect(JSON.stringify(fork.messages)).toContain('All 48 tests are green');
    expect(JSON.stringify(fork.messages)).not.toContain(
      'background review passed',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('reply actions retain their expanded touch targets outside the footer row', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'reply-actions-touch-'),
  );
  seedReplyActions(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  try {
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(target.worktreeId);
    const cdp = await window.context().newCDPSession(window);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    const action = window.getByTestId('turn-more-actions').nth(1);
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeVisible();
    await expect
      .poll(() =>
        action.evaluate((button) => {
          const rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y - 6,
          );
          return hit === button || button.contains(hit);
        }),
      )
      .toBe(true);
    const rect = await action.boundingBox();
    expect(rect).not.toBeNull();
    await window.mouse.click(rect.x + rect.width / 2, rect.y - 6);
    await expect(window.getByTestId('turn-more-actions-menu')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
