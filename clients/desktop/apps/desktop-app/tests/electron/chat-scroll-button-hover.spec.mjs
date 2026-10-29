// CAN-4276: real transcript scroll, both appearances and early-access choices.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/index.mjs';
import { seedScrollButtonChat } from './seeders/scrollButton.mjs';

const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'scroll-button-chat';

/** The alpha of the button's computed background color. */
function backgroundAlpha(button) {
  return button.evaluate((element) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D context unavailable');
    context.fillStyle = getComputedStyle(element).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3] / 255;
  });
}

for (const colorMode of ['light', 'dark']) {
  test(`Scroll to bottom stays opaque for every user in ${colorMode} mode and returns to the tail`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-scroll-button-'),
    );
    seedScrollButtonChat(userDataDir);
    writeJson(path.join(userDataDir, 'preferences.json'), {
      version: 1,
      preferences: { colorMode },
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`).click();
      const chat = window.locator(
        `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
      );
      await expect(chat).toContainText('Answer 29.');

      const button = chat.getByTestId('chat-scroll-to-bottom');
      // Scroll the transcript to its top, so the button shows.
      async function showButton() {
        await chat.getByText('Answer 29.').hover();
        await expect
          .poll(async () => {
            await window.mouse.wheel(0, -5_000);
            return button.isVisible();
          })
          .toBe(true);
      }

      for (const enabled of [false, true]) {
        await window.evaluate(
          (choice) =>
            window.api.experiments.setChoice({
              experimentId: 'early-access',
              enabled: choice,
            }),
          enabled,
        );
        await showButton();
        await expect(button).toBeVisible();
        await button.hover();
        await button.evaluate(async (element) => {
          void getComputedStyle(element).backgroundColor;
          await Promise.all(
            element.getAnimations().map((animation) => animation.finished),
          );
        });
        await expect.poll(() => backgroundAlpha(button)).toBe(1);
        await expect(button).toHaveAccessibleName('Scroll to bottom');
        if (enabled) {
          await button.focus();
          await button.press('Enter');
        } else {
          await button.click();
        }
        await expect(button).toBeHidden();
        await expect(chat.getByText('Answer 29.')).toBeInViewport();
      }
    } finally {
      await closeCanopy(electronApp, userDataDir).catch(() => undefined);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}
