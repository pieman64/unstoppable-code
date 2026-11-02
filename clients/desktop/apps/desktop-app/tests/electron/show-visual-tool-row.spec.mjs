import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedDesktopShowVisualChat,
  SHOW_VISUAL_HTML,
  SHOW_VISUAL_TITLE,
} from './fixtures/show-visual-tool-row.mjs';
import {
  PREVIEW_VISUAL_HTML,
  seedDesktopPreviewVisualChat,
} from './fixtures/preview-visual-tool-row.mjs';

test('shows a ShowVisual app row without inline HTML on desktop', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-show-visual-'),
  );
  let electronApp;
  try {
    seedDesktopShowVisualChat(userDataDir);
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // Individual-step assertions use the Detailed preference.
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await app.openChatPage();

    const page = window.getByTestId('page-chat');
    await expect(page).toBeVisible();
    await page.getByRole('button', { name: /Agent steps: 1 app/i }).click();
    const row = page.getByTestId('chat-tool-call');
    await expect(row).toContainText('Show visual');
    await expect(row).toContainText(SHOW_VISUAL_TITLE);
    await expect(row).not.toContainText(SHOW_VISUAL_HTML);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    else rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('shows a PreviewVisual app row with its width and appearance, never its HTML', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-preview-visual-row-'),
  );
  let electronApp;
  try {
    seedDesktopPreviewVisualChat(userDataDir);
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    // Individual-step assertions use the Detailed preference.
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await app.openChatPage();

    const page = window.getByTestId('page-chat');
    await expect(page).toBeVisible();
    await page.getByRole('button', { name: /Agent steps: 1 app/i }).click();
    const row = page.getByTestId('chat-tool-call');
    await expect(row).toContainText('Preview visual');
    await expect(row).toContainText('520px, dark');
    await expect(page).not.toContainText(PREVIEW_VISUAL_HTML);
    // The stored result holds a placeholder, never image bytes.
    await expect(page).not.toContainText('data:image');
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    else rmSync(userDataDir, { recursive: true, force: true });
  }
});
